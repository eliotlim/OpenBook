import {DialogDescription, DialogFooter, DialogHeader, DialogTitle} from '@/components/ui/dialog';
import {Label} from '@/components/ui/label';
import {Input} from '@/components/ui/input';
import {Button} from '@/components/ui/button';
import {PersonIcon} from '@radix-ui/react-icons';
import {PaintBrushIcon, WrenchIcon} from '@heroicons/react/24/outline';

export default function SettingsDialogContent() {
  return (
    <>
      <div className="flex flex-row gap-2 m-0">
        <div className="flex flex-col bg-sheet-1 text-sheet-1-foreground pl-4 pt-8 pb-8 pr-4 rounded-l-lg gap-1">
          <h4 className="text-sm font-semibold pb-2 px-2">Settings</h4>
          <Button variant="ghost" className="flex justify-start h-7 px-2">
            <WrenchIcon className="w-4 h-4 mr-2"/>
            General
          </Button>
          <Button variant="ghost" className="flex justify-start h-7 px-2">
            <PaintBrushIcon className="w-4 h-4 mr-2"/>
            Appearance
          </Button>
          <Button variant="ghost" className="flex justify-start h-7 px-2">
            <PersonIcon className="w-4 h-4 mr-2"/>
            Profile
          </Button>
        </div>
        <div className="flex flex-col pl-4 pt-8 pb-8 pr-8">
          <DialogHeader>
            <DialogTitle>Profile</DialogTitle>
            <DialogDescription>
              Make changes to your profile here.
            </DialogDescription>
          </DialogHeader>
          <div className="grid gap-4 py-4">
            <div className="grid grid-cols-4 items-center gap-4">
              <Label htmlFor="name" className="text-right">
                Name
              </Label>
              <Input id="name" value="Pedro Duarte" className="col-span-3"/>
            </div>
            <div className="grid grid-cols-4 items-center gap-4">
              <Label htmlFor="username" className="text-right">
                Username
              </Label>
              <Input id="username" value="@peduarte" className="col-span-3"/>
            </div>
          </div>
          <DialogFooter>
            <Button type="submit">Save changes</Button>
          </DialogFooter>

        </div>
      </div>
    </>
  );
}
