import {Dialog, DialogContent, DialogTrigger} from '@/components/ui/dialog';
import {Button} from '@/components/ui/button';
import {GearIcon} from '@radix-ui/react-icons';
import {SettingsDialogContent} from '@/components/index';

export default function SettingsDialog() {
  return (

    <Dialog>
      <DialogTrigger asChild>
        <Button variant="ghost" className="flex flex-grow justify-start">
          <GearIcon className="w-4 h-4 mr-2"/>
          Settings
        </Button>
      </DialogTrigger>
      <DialogContent className="sm:max-w-[800px] p-0">
        <SettingsDialogContent/>
      </DialogContent>
    </Dialog>
  );
}
