import {useMemo, useRef, useState} from 'react';
import {useTranslation} from '@/providers';
import {cn} from '@/lib/utils';
import {searchEmojis} from '@/lib/emoji';
import {EMOJI_CATEGORIES} from '@/lib/emojiData';
import {LUCIDE_ICONS, LUCIDE_ICON_NAMES, LUCIDE_PREFIX} from '@/lib/lucideIcons';
import {pushIconRecent, readIconRecents} from '@/lib/iconRecents';
import type {TKey} from '@/i18n';

type Source = 'emoji' | 'icon';

/**
 * The in-house icon picker — emoji glyphs + a curated set of Lucide icons —
 * replacing the third-party `emoji-picker-react`. Native glyphs only (no
 * network), our own design-system chrome, search across the full emoji dataset
 * (via {@link searchEmojis}) and the icon registry, plus recents. It's the lazy
 * payload behind {@link components/EmojiPickerHost}; the {@link lib/emojiPicker}
 * bridge / {@link components/IconPicker} open API is unchanged.
 *
 * Structured around an icon *source* (emoji | icon) so further sources (custom
 * uploads, other libraries) can slot in later (#5).
 */
export default function EmojiGrid({
  value,
  onPick,
}: {
  /** The current icon value, used to highlight it and pick the opening tab. */
  value?: string;
  onPick: (value: string) => void;
}) {
  const {t} = useTranslation();
  const [source, setSource] = useState<Source>(value?.startsWith(LUCIDE_PREFIX) ? 'icon' : 'emoji');
  const [query, setQuery] = useState('');
  // Snapshot recents once per open so picking doesn't reshuffle the grid mid-use.
  const recents = useRef(readIconRecents()).current;

  const choose = (v: string) => {
    pushIconRecent(v);
    onPick(v);
  };

  return (
    <div className="flex h-[372px] w-[332px] flex-col bg-popover text-popover-foreground">
      <div className="flex items-center gap-1 p-2 pb-1.5">
        <Tab active={source === 'emoji'} onClick={() => setSource('emoji')} label={t('emoji.tabEmoji')} />
        <Tab active={source === 'icon'} onClick={() => setSource('icon')} label={t('emoji.tabIcons')} />
      </div>
      <div className="px-2 pb-2">
        <input
          autoFocus
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder={t(source === 'emoji' ? 'emoji.searchEmoji' : 'emoji.searchIcons')}
          className="h-8 w-full rounded-md border border-input bg-background px-2.5 text-sm outline-hidden placeholder:text-muted-foreground focus-visible:ring-2 focus-visible:ring-ring"
          aria-label={t('emoji.search')}
        />
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto px-2 pb-2">
        {source === 'emoji' ? (
          <EmojiBody query={query} recents={recents} current={value} onPick={choose} />
        ) : (
          <IconBody query={query} recents={recents} current={value} onPick={choose} />
        )}
      </div>
    </div>
  );
}

function Tab({active, onClick, label}: {active: boolean; onClick: () => void; label: string}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        'flex-1 cursor-pointer rounded-md px-2.5 py-1 text-sm font-medium transition-colors',
        active ? 'bg-accent text-accent-foreground' : 'text-muted-foreground hover:bg-hover',
      )}
    >
      {label}
    </button>
  );
}

/** A section heading inside the scroll area. */
function SectionLabel({children}: {children: React.ReactNode}) {
  return (
    <div className="sticky top-0 z-10 bg-popover px-1 pb-1 pt-1.5 text-xs font-medium uppercase tracking-wide text-muted-foreground/70">
      {children}
    </div>
  );
}

const GRID = 'grid grid-cols-8 gap-0.5';

/** One emoji glyph button. */
function EmojiCell({glyph, active, onPick}: {glyph: string; active: boolean; onPick: (v: string) => void}) {
  return (
    <button
      type="button"
      onClick={() => onPick(glyph)}
      className={cn(
        'flex h-9 w-9 items-center justify-center rounded-md text-[20px] leading-none transition-colors hover:bg-hover',
        active && 'bg-accent ring-1 ring-primary',
      )}
      title={glyph}
    >
      {glyph}
    </button>
  );
}

function EmojiBody({
  query,
  recents,
  current,
  onPick,
}: {
  query: string;
  recents: string[];
  current?: string;
  onPick: (v: string) => void;
}) {
  const {t} = useTranslation();
  const results = useMemo(() => (query.trim() ? searchEmojis(query, 64).map((m) => m.emoji) : null), [query]);
  const recentEmojis = recents.filter((v) => !v.startsWith(LUCIDE_PREFIX));

  if (results) {
    if (results.length === 0) return <Empty text={t('emoji.noResults')} />;
    return (
      <div className={GRID}>
        {results.map((g, i) => (
          <EmojiCell key={`${g}-${i}`} glyph={g} active={g === current} onPick={onPick} />
        ))}
      </div>
    );
  }

  return (
    <>
      {recentEmojis.length > 0 && (
        <section>
          <SectionLabel>{t('emoji.recent')}</SectionLabel>
          <div className={GRID}>
            {recentEmojis.map((g, i) => (
              <EmojiCell key={`r-${g}-${i}`} glyph={g} active={g === current} onPick={onPick} />
            ))}
          </div>
        </section>
      )}
      {EMOJI_CATEGORIES.map((cat) => (
        <section key={cat.id}>
          <SectionLabel>{t(`emoji.cat.${cat.id}` as TKey)}</SectionLabel>
          <div className={GRID}>
            {cat.emojis.map((g, i) => (
              <EmojiCell key={`${cat.id}-${g}-${i}`} glyph={g} active={g === current} onPick={onPick} />
            ))}
          </div>
        </section>
      ))}
    </>
  );
}

/** One Lucide icon button. */
function IconCell({name, active, onPick}: {name: string; active: boolean; onPick: (v: string) => void}) {
  const Icon = LUCIDE_ICONS[name];
  if (!Icon) return null;
  return (
    <button
      type="button"
      onClick={() => onPick(`${LUCIDE_PREFIX}${name}`)}
      className={cn(
        'flex h-9 w-9 items-center justify-center rounded-md text-foreground transition-colors hover:bg-hover',
        active && 'bg-accent ring-1 ring-primary',
      )}
      title={name}
      aria-label={name}
    >
      <Icon className="h-[18px] w-[18px]" />
    </button>
  );
}

function IconBody({
  query,
  recents,
  current,
  onPick,
}: {
  query: string;
  recents: string[];
  current?: string;
  onPick: (v: string) => void;
}) {
  const {t} = useTranslation();
  const q = query.trim().toLowerCase();
  const names = useMemo(
    () => (q ? LUCIDE_ICON_NAMES.filter((n) => n.toLowerCase().includes(q)) : LUCIDE_ICON_NAMES),
    [q],
  );
  const currentName = current?.startsWith(LUCIDE_PREFIX) ? current.slice(LUCIDE_PREFIX.length) : undefined;
  const recentIcons = recents
    .filter((v) => v.startsWith(LUCIDE_PREFIX))
    .map((v) => v.slice(LUCIDE_PREFIX.length))
    .filter((n) => LUCIDE_ICONS[n]);

  if (names.length === 0) return <Empty text={t('emoji.noResults')} />;

  return (
    <>
      {!q && recentIcons.length > 0 && (
        <section>
          <SectionLabel>{t('emoji.recent')}</SectionLabel>
          <div className={GRID}>
            {recentIcons.map((n, i) => (
              <IconCell key={`r-${n}-${i}`} name={n} active={n === currentName} onPick={onPick} />
            ))}
          </div>
        </section>
      )}
      <section>
        {!q && <SectionLabel>{t('emoji.tabIcons')}</SectionLabel>}
        <div className={GRID}>
          {names.map((n) => (
            <IconCell key={n} name={n} active={n === currentName} onPick={onPick} />
          ))}
        </div>
      </section>
    </>
  );
}

function Empty({text}: {text: string}) {
  return <div className="flex h-24 items-center justify-center text-sm text-muted-foreground">{text}</div>;
}
