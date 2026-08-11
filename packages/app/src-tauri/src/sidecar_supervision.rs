use std::time::{Duration, Instant};

use serde::Serialize;

pub(crate) const MAX_RESPAWN_ATTEMPTS: u32 = 5;
pub(crate) const INITIAL_RESPAWN_BACKOFF: Duration = Duration::from_secs(1);
pub(crate) const HEALTHY_UPTIME: Duration = Duration::from_secs(60);
pub(crate) const STDERR_TAIL_LINES: usize = 20;

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub(crate) enum SidecarLifecycle {
    Dead,
    Respawning,
    Running,
}

/// Stable webview contract for both the `sidecar-state` event and the
/// `sidecar_state` command. BOOT-5/BOOT-8 consume these exact camelCase fields;
/// add fields compatibly, but do not rename them or change their value types.
/// `running` means "process spawned", not "socket accepting"; consumers must not
/// gate IPC readiness on it.
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct SidecarStatePayload {
    pub(crate) state: SidecarLifecycle,
    /// Automatic retry attempts consumed in the current crash burst (0..=5).
    pub(crate) attempts: u32,
    pub(crate) last_exit_code: Option<i32>,
    /// At most the last 20 complete stderr lines from the most recent death.
    pub(crate) last_stderr_tail: Vec<String>,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum FailureDecision {
    RetryAfter(Duration),
    Exhausted,
}

/// Pure sidecar lifecycle policy. Process spawning, timers, and Tauri events live
/// in `main.rs`; keeping all retry/generation decisions here makes crash-loop and
/// deliberate-stop behavior deterministic under unit tests.
pub(crate) struct SidecarSupervisor {
    generation: u64,
    running_since: Option<Instant>,
    shutting_down: bool,
    payload: SidecarStatePayload,
}

impl SidecarSupervisor {
    pub(crate) fn new(managed: bool) -> Self {
        Self {
            generation: 0,
            running_since: None,
            shutting_down: false,
            payload: SidecarStatePayload {
                // Dev builds use the external server and do not supervise a
                // bundled process, so they must not surface a false degraded state.
                state: if managed {
                    SidecarLifecycle::Respawning
                } else {
                    SidecarLifecycle::Running
                },
                attempts: 0,
                last_exit_code: None,
                last_stderr_tail: Vec::new(),
            },
        }
    }

    pub(crate) fn snapshot(&self) -> SidecarStatePayload {
        self.payload.clone()
    }

    /// Invalidate every prior process/timer and start an immediate, user- or
    /// configuration-requested launch with a fresh retry budget.
    pub(crate) fn begin_forced_respawn(&mut self) -> Option<(u64, SidecarStatePayload)> {
        if self.shutting_down {
            return None;
        }
        self.generation = self.generation.wrapping_add(1);
        self.running_since = None;
        self.payload.state = SidecarLifecycle::Respawning;
        self.payload.attempts = 0;
        Some((self.generation, self.snapshot()))
    }

    /// Allocate a new process generation after the backoff for `expected_generation`.
    /// A deliberate replacement or shutdown invalidates the pending timer.
    pub(crate) fn begin_retry(&mut self, expected_generation: u64) -> Option<u64> {
        if self.shutting_down
            || self.generation != expected_generation
            || self.payload.state != SidecarLifecycle::Respawning
        {
            return None;
        }
        self.generation = self.generation.wrapping_add(1);
        Some(self.generation)
    }

    pub(crate) fn spawned(&mut self, generation: u64, now: Instant) -> Option<SidecarStatePayload> {
        if self.shutting_down || self.generation != generation {
            return None;
        }
        self.running_since = Some(now);
        self.payload.state = SidecarLifecycle::Running;
        Some(self.snapshot())
    }

    /// Record either a child termination or an attempted launch that failed.
    /// Returns `None` for an obsolete generation, which is how deliberate stops
    /// are kept out of the automatic supervision loop.
    pub(crate) fn failed(
        &mut self,
        generation: u64,
        now: Instant,
        exit_code: Option<i32>,
        stderr_tail: Vec<String>,
    ) -> Option<(SidecarStatePayload, FailureDecision)> {
        if self.shutting_down || self.generation != generation {
            return None;
        }

        if self
            .running_since
            .is_some_and(|started| now.saturating_duration_since(started) >= HEALTHY_UPTIME)
        {
            self.payload.attempts = 0;
        }
        self.running_since = None;
        self.payload.last_exit_code = exit_code;
        self.payload.last_stderr_tail = tail(stderr_tail);

        let decision = if self.payload.attempts < MAX_RESPAWN_ATTEMPTS {
            self.payload.attempts += 1;
            self.payload.state = SidecarLifecycle::Respawning;
            FailureDecision::RetryAfter(backoff_for_attempt(self.payload.attempts))
        } else {
            self.payload.state = SidecarLifecycle::Dead;
            FailureDecision::Exhausted
        };
        Some((self.snapshot(), decision))
    }

    /// Reset the burst only if this exact generation has remained healthy for the
    /// full window. Returns a payload only when the externally visible counter changes.
    pub(crate) fn mark_healthy(
        &mut self,
        generation: u64,
        now: Instant,
    ) -> Option<SidecarStatePayload> {
        if self.shutting_down
            || self.generation != generation
            || self.payload.state != SidecarLifecycle::Running
            || self.payload.attempts == 0
            || self
                .running_since
                .is_none_or(|started| now.saturating_duration_since(started) < HEALTHY_UPTIME)
        {
            return None;
        }
        self.payload.attempts = 0;
        Some(self.snapshot())
    }

    /// Invalidate the live receiver and all retry/healthy timers before the
    /// graceful BOOT-7 stop path signals the child.
    pub(crate) fn invalidate_for_shutdown(&mut self) {
        self.shutting_down = true;
        self.running_since = None;
        self.generation = self.generation.wrapping_add(1);
    }
}

fn backoff_for_attempt(attempt: u32) -> Duration {
    INITIAL_RESPAWN_BACKOFF * 2u32.pow(attempt.saturating_sub(1))
}

fn tail(lines: Vec<String>) -> Vec<String> {
    let skip = lines.len().saturating_sub(STDERR_TAIL_LINES);
    lines.into_iter().skip(skip).collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn start(supervisor: &mut SidecarSupervisor, now: Instant) -> u64 {
        let (generation, _) = supervisor.begin_forced_respawn().unwrap();
        supervisor.spawned(generation, now).unwrap();
        generation
    }

    #[test]
    fn crash_loop_doubles_backoff_and_stops_after_five_retries() {
        let now = Instant::now();
        let mut supervisor = SidecarSupervisor::new(true);
        let mut generation = start(&mut supervisor, now);

        for (index, seconds) in [1, 2, 4, 8, 16].into_iter().enumerate() {
            let (payload, decision) = supervisor
                .failed(generation, now, Some(70 + index as i32), Vec::new())
                .unwrap();
            assert_eq!(payload.state, SidecarLifecycle::Respawning);
            assert_eq!(payload.attempts, index as u32 + 1);
            assert_eq!(
                decision,
                FailureDecision::RetryAfter(Duration::from_secs(seconds))
            );

            generation = supervisor.begin_retry(generation).unwrap();
            supervisor.spawned(generation, now).unwrap();
        }

        let (payload, decision) = supervisor
            .failed(generation, now, Some(99), vec!["final crash".into()])
            .unwrap();
        assert_eq!(decision, FailureDecision::Exhausted);
        assert_eq!(payload.state, SidecarLifecycle::Dead);
        assert_eq!(payload.attempts, MAX_RESPAWN_ATTEMPTS);
        assert_eq!(payload.last_exit_code, Some(99));
        assert_eq!(payload.last_stderr_tail, vec!["final crash"]);
    }

    #[test]
    fn healthy_uptime_resets_the_retry_burst() {
        let now = Instant::now();
        let mut supervisor = SidecarSupervisor::new(true);
        let generation = start(&mut supervisor, now);
        let (_, decision) = supervisor
            .failed(generation, now, Some(1), Vec::new())
            .unwrap();
        assert_eq!(
            decision,
            FailureDecision::RetryAfter(Duration::from_secs(1))
        );

        let generation = supervisor.begin_retry(generation).unwrap();
        supervisor.spawned(generation, now).unwrap();
        let healthy = supervisor
            .mark_healthy(generation, now + HEALTHY_UPTIME)
            .unwrap();
        assert_eq!(healthy.state, SidecarLifecycle::Running);
        assert_eq!(healthy.attempts, 0);

        let (payload, decision) = supervisor
            .failed(generation, now + HEALTHY_UPTIME, Some(2), Vec::new())
            .unwrap();
        assert_eq!(payload.attempts, 1);
        assert_eq!(
            decision,
            FailureDecision::RetryAfter(Duration::from_secs(1))
        );
    }

    #[test]
    fn deliberate_respawn_invalidates_the_old_termination_and_resets_the_bound() {
        let now = Instant::now();
        let mut supervisor = SidecarSupervisor::new(true);
        let old_generation = start(&mut supervisor, now);
        supervisor
            .failed(old_generation, now, Some(1), Vec::new())
            .unwrap();

        let (new_generation, payload) = supervisor.begin_forced_respawn().unwrap();
        assert_ne!(new_generation, old_generation);
        assert_eq!(payload.state, SidecarLifecycle::Respawning);
        assert_eq!(payload.attempts, 0);
        assert!(supervisor
            .failed(old_generation, now, Some(0), vec!["expected".into()])
            .is_none());
    }

    #[test]
    fn shutdown_invalidates_terminations_and_pending_retries() {
        let now = Instant::now();
        let mut supervisor = SidecarSupervisor::new(true);
        let generation = start(&mut supervisor, now);
        supervisor
            .failed(generation, now, Some(1), Vec::new())
            .unwrap();

        supervisor.invalidate_for_shutdown();
        assert!(supervisor.begin_retry(generation).is_none());
        assert!(supervisor
            .failed(generation, now, Some(0), Vec::new())
            .is_none());
        assert!(supervisor.begin_forced_respawn().is_none());
    }

    #[test]
    fn dead_state_can_be_restarted_with_a_fresh_bound() {
        let now = Instant::now();
        let mut supervisor = SidecarSupervisor::new(true);
        let mut generation = start(&mut supervisor, now);
        for _ in 0..MAX_RESPAWN_ATTEMPTS {
            supervisor
                .failed(generation, now, Some(1), Vec::new())
                .unwrap();
            generation = supervisor.begin_retry(generation).unwrap();
            supervisor.spawned(generation, now).unwrap();
        }
        let (dead, _) = supervisor
            .failed(generation, now, Some(1), Vec::new())
            .unwrap();
        assert_eq!(dead.state, SidecarLifecycle::Dead);

        let (_, restarting) = supervisor.begin_forced_respawn().unwrap();
        assert_eq!(restarting.state, SidecarLifecycle::Respawning);
        assert_eq!(restarting.attempts, 0);
    }

    #[test]
    fn stderr_diagnostics_keep_only_the_last_twenty_lines() {
        let now = Instant::now();
        let mut supervisor = SidecarSupervisor::new(true);
        let generation = start(&mut supervisor, now);
        let lines: Vec<_> = (0..25).map(|line| format!("line {line}")).collect();
        let (payload, _) = supervisor.failed(generation, now, None, lines).unwrap();
        assert_eq!(payload.last_stderr_tail.len(), STDERR_TAIL_LINES);
        assert_eq!(payload.last_stderr_tail.first().unwrap(), "line 5");
        assert_eq!(payload.last_stderr_tail.last().unwrap(), "line 24");
    }

    #[test]
    fn payload_serialization_matches_the_webview_contract() {
        let payload = SidecarStatePayload {
            state: SidecarLifecycle::Dead,
            attempts: 5,
            last_exit_code: Some(17),
            last_stderr_tail: vec!["fatal".into()],
        };
        assert_eq!(
            serde_json::to_value(payload).unwrap(),
            serde_json::json!({
                "state": "dead",
                "attempts": 5,
                "lastExitCode": 17,
                "lastStderrTail": ["fatal"],
            })
        );
    }
}
