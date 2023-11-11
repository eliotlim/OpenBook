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
    <div className="flex flex-1 flex-row items-center">
      {props.icon ?
        <div className="h-8 w-8 mr-2">
          <span className="h-8 w-8 text-2xl">{props.icon}</span>
        </div>
        : <GlobeIcon className="h-8 w-8 mr-2"/>
      }
      <div className="flex flex-1 flex-col">
        <div className="flex gap-2">
          <span className="text-start whitespace-nowrap overflow-hidden w-40 text-ellipsis font-bold">{props.name}</span>
        </div>
        <div className="flex">
          <span className="text-start whitespace-nowrap overflow-hidden text-ellipsis text-xs text-muted-foreground font-normal">
            {`${url.protocol}//`}
          </span>
          <span className="text-start whitespace-nowrap overflow-hidden w-32 text-ellipsis text-xs text-muted-foreground font-semibold">
            {location}
          </span>
        </div>
      </div>
    </div>
  );
}