export interface ErrorLogEntry {
  ts: number;
  subsystem: string;
  code?: string;
  message: string;
  detail?: string;
}

type ErrorLogInput = Omit<ErrorLogEntry, 'ts'> & {ts?: number};
type Listener = () => void;

const CAPACITY = 50;
let entries: ErrorLogEntry[] = [];
const listeners = new Set<Listener>();

/** Add an error to the process-local buffer. Entries are retained newest first. */
export function push(input: ErrorLogInput): ErrorLogEntry {
  const entry: ErrorLogEntry = {...input, ts: input.ts ?? Date.now()};
  entries = [entry, ...entries].slice(0, CAPACITY);
  listeners.forEach((listener) => {
    try {
      listener();
    } catch {
      // A diagnostic subscriber must not block later listeners or unwind into
      // the SDK callback that reported the original error.
    }
  });
  return entry;
}

/** Return a snapshot so consumers cannot mutate the shared ring. */
export function list(): ErrorLogEntry[] {
  return entries.map((entry) => ({...entry}));
}

export function subscribe(listener: Listener): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** Plain-text diagnostic dump, newest first, ready for the clipboard. */
export function copyText(): string {
  return entries
    .map(({ts, subsystem, code, message, detail}) => {
      const label = code ? `${subsystem}/${code}` : subsystem;
      return `[${new Date(ts).toISOString()}] ${label}: ${message}${detail ? ` — ${detail}` : ''}`;
    })
    .join('\n');
}
