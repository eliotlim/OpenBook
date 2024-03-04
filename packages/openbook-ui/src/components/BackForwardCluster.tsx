import {Button} from '@/components/ui/button';
import {ChevronLeftIcon, ChevronRightIcon} from '@radix-ui/react-icons';

export default function BackForwardCluster() {
  return (

    <div
    >
      <Button
        variant="ghost"
        className="px-2 py-1 rounded-tr-none rounded-br-none"
      >
        <ChevronLeftIcon className="h-4 w-4"/>
      </Button>
      <Button
        variant="ghost"
        className="px-2 rounded-tl-none rounded-bl-none"
      >
        <ChevronRightIcon className="h-4 w-4"/>
      </Button>
    </div>
  );
}
