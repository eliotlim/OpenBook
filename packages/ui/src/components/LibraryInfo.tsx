import {GlobeIcon} from '@radix-ui/react-icons';
import {t} from '@/i18n';

export interface LibraryInfoProps {
  name: string,
  url: string,
  icon?: string,
}

// A short, friendly label for the library's connection. An empty url means
// the local/default server ("This device"); otherwise show the host (or the
// decoded path for file:// URLs), falling back to the raw value if unparseable.
function describeLocation(raw: string): string {
  if (!raw.trim()) return t('library.thisDevice');
  try {
    const url = new URL(raw);
    switch (url.protocol) {
    case 'file:':
      return decodeURI(url.pathname);
    default:
      return url.host || raw;
    }
  } catch {
    return raw;
  }
}

export default function LibraryInfo(props: LibraryInfoProps) {
  const location = describeLocation(props.url);
  // A library named after its own server URL (the auto-name for a plain
  // remote connection) would render the same string twice — drop the subtitle.
  const subtitle = location === props.name.trim() ? null : location;
  return (
    <div className="flex min-w-0 flex-1 flex-row items-center">
      {props.icon ? (
        <span className="mr-2 flex h-8 w-8 shrink-0 items-center justify-center text-2xl leading-none">
          {props.icon}
        </span>
      ) : (
        <GlobeIcon className="mr-2 h-8 w-8 shrink-0 text-muted-foreground" />
      )}
      <div className="flex min-w-0 flex-1 flex-col">
        <span className="truncate text-start font-semibold leading-tight">{props.name}</span>
        {subtitle && (
          <span className="truncate text-start text-xs font-normal text-muted-foreground">
            {subtitle}
          </span>
        )}
      </div>
    </div>
  );
}