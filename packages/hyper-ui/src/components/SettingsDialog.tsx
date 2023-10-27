import {Dialog, DialogContent, DialogTrigger} from '@/components/ui/dialog';
import {Button} from '@/components/ui/button';
import {GearIcon} from '@radix-ui/react-icons';
import {SettingsDialogContent} from '@/components/index';
import {useHud} from "@/providers";
import React from 'react';

export default function SettingsDialog() {
  const {hud, setHud} = useHud();

  const open = hud.settings.open;
  const setOpen = React.useCallback((open: boolean) => {
    setHud(draft => {draft.settings.open = open; return draft;});
  }, [setHud]);

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button variant="ghost" className="flex flex-grow justify-start h-7">
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
