import {GlobeIcon} from '@radix-ui/react-icons';
import {Badge} from '@/components/ui/badge';

export interface WorkspaceInfoProps {
  name: string,
  url: string,
}

export default function WorkspaceInfo( props: WorkspaceInfoProps) {
  const url = new URL(props.url);
  const badge = (() => {
    switch (url.protocol) {
    case 'file:':
      return <Badge className="px-1" variant="outline">Local</Badge>;
    case 'https:':
      return <Badge className="px-1" variant="default">Shared</Badge>;
    default:
      return <Badge className="px-1" variant="secondary">Unknown</Badge>;
    }
  })();
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
      <GlobeIcon className="h-8 w-8 mr-2"/>
      <div className="flex flex-1 flex-col">
        <div className="flex gap-2"><span className="whitespace-nowrap">{props.name}</span>{badge}</div>
        <p className="flex text-xs font-normal text-muted-foreground text-ellipsis whitespace-nowrap">
          {location}
        </p>
      </div>
    </div>
  );
}