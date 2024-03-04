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
          <DialogTitle>About Hyper</DialogTitle>
          <DialogDescription>
            Hyper is a new way to make a space your own on the web.
          </DialogDescription>
        </DialogHeader>
        <DialogDescription>
          Doggo Ipsum woofers long bois, borkdrive puggo. Puggo wrinkler puggo, borkf long bois. Puggo long bois.
        </DialogDescription>
        <DialogFooter>
          <Button variant="ghost">Learn more</Button>
          <Button variant="ghost">Get support</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
