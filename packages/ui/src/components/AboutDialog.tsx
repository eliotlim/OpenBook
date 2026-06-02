import {
  Dialog,
  DialogContent,
  DialogDescription, DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger
} from '@/components/ui/dialog';
import {Button} from '@/components/ui/button';
import {InformationCircleIcon} from '@heroicons/react/24/outline';

export default function AboutDialog() {
  return (
    <Dialog>
      <DialogTrigger asChild>
        <Button variant="ghost" className="flex flex-grow gap-2">
          <InformationCircleIcon className="h-4 w-4"/>
          About
        </Button>
      </DialogTrigger>
      <DialogContent className="sm:max-w-[425px]">
        <DialogHeader>
          <DialogTitle>About OpenBook</DialogTitle>
          <DialogDescription>A second brain for thinking in public and in private.</DialogDescription>
        </DialogHeader>
        <DialogDescription>
          OpenBook is a notebook for writing, organizing, and connecting your ideas — with live,
          reactive blocks that turn notes into something you can compute with. Your pages are yours,
          stored locally and synced on your terms.
        </DialogDescription>
        <DialogFooter>
          <Button variant="ghost" asChild>
            <a href="https://github.com/eliotlim/openbook" target="_blank" rel="noreferrer noopener">
              Learn more
            </a>
          </Button>
          <Button variant="ghost" asChild>
            <a href="https://github.com/eliotlim/openbook/issues" target="_blank" rel="noreferrer noopener">
              Get support
            </a>
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
