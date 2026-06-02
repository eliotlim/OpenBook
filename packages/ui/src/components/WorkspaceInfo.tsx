import {GlobeIcon} from '@radix-ui/react-icons';

export interface WorkspaceInfoProps {
  name: string,
  url: string,
  icon?: string,
}

export default function WorkspaceInfo( props: WorkspaceInfoProps) {
  const url = new URL(props.url);
  const location = ((() => {
    switch (url.protocol) {
    case 'file:':
      return decodeURI(url.pathname);
    case 'https:':
      return url.hostname;
    default:
      return 'Unknown';
    }
  })());
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
        <span className="truncate text-start text-xs font-normal text-muted-foreground">
          {`${url.protocol}//${location}`}
        </span>
      </div>
    </div>
  );
}