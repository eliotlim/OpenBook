import {useState} from 'react';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import {Button} from '@/components/ui/button';
import {Input} from '@/components/ui/input';
import {Label} from '@/components/ui/label';
import WorkspaceInfo from '@/components/WorkspaceInfo';
import {ChevronUpDownIcon, PlusIcon} from '@heroicons/react/24/outline';
import {CheckIcon, GlobeIcon} from '@radix-ui/react-icons';
import {Trash2} from 'lucide-react';
import {useWorkspace, workspaceHostLabel} from '@/providers';

/**
 * The workspace switcher. `variant` controls the trigger only:
 *  - `sidebar` (default) — the full-width, two-line button at the top of the
 *    sidebar (web);
 *  - `titlebar` — a compact icon + name button for the desktop titlebar.
 * The dropdown contents (workspace list + "add a workspace") are identical.
 */
export default function WorkspaceSelectMenu({variant = 'sidebar'}: {variant?: 'sidebar' | 'titlebar'}) {
  const {workspaces, workspace, selectWorkspace, addWorkspace, removeWorkspace} = useWorkspace();

  const [addOpen, setAddOpen] = useState(false);
  const [name, setName] = useState('');
  const [serverUrl, setServerUrl] = useState('');
  const [icon, setIcon] = useState('');
  const [error, setError] = useState<string | null>(null);

  const resetForm = () => {
    setName('');
    setServerUrl('');
    setIcon('');
    setError(null);
  };

  const closeAdd = () => {
    setAddOpen(false);
    resetForm();
  };

  const submitAdd = () => {
    const url = serverUrl.trim();
    if (!url) {
      setError('Enter the server URL for this workspace.');
      return;
    }
    try {
      // Validate the URL shape early so a typo doesn't silently fail on connect.
      new URL(url);
    } catch {
      setError('That doesn’t look like a valid URL.');
      return;
    }
    addWorkspace({name, serverUrl: url, icon});
    closeAdd();
  };

  return (
    <>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          {variant === 'titlebar' ? (
            <Button variant="ghost" className="flex h-7 max-w-[200px] items-center gap-1.5 px-2">
              {workspace.icon ? (
                <span className="shrink-0 text-base leading-none">{workspace.icon}</span>
              ) : (
                <GlobeIcon className="h-4 w-4 shrink-0 text-muted-foreground" />
              )}
              <span className="truncate text-sm font-medium">{workspace.name}</span>
              <ChevronUpDownIcon className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
            </Button>
          ) : (
            <Button variant="ghost" className="flex h-12 w-full justify-start gap-1 px-2">
              <WorkspaceInfo icon={workspace.icon} name={workspace.name} url={workspace.serverUrl ?? ''} />
              <ChevronUpDownIcon className="h-4 w-4 shrink-0 text-muted-foreground" />
            </Button>
          )}
        </DropdownMenuTrigger>
        <DropdownMenuContent align="start" className="w-72 bg-sheet-2 text-sheet-2-foreground">
          <DropdownMenuLabel>Workspaces</DropdownMenuLabel>
          <DropdownMenuSeparator />
          {workspaces.map((ws) => {
            const active = ws.id === workspace.id;
            const canRemove = !active && workspaces.length > 1;
            return (
              <DropdownMenuItem
                key={ws.id}
                onSelect={() => selectWorkspace(ws.id)}
                className="group flex items-center gap-2"
              >
                <span className="flex h-6 w-6 shrink-0 items-center justify-center text-lg leading-none">
                  {ws.icon}
                </span>
                <span className="flex min-w-0 flex-1 flex-col">
                  <span className="truncate text-sm">{ws.name}</span>
                  <span className="truncate text-xs text-muted-foreground">
                    {workspaceHostLabel(ws.serverUrl)}
                  </span>
                </span>
                {active && <CheckIcon className="h-4 w-4 shrink-0 text-brand" />}
                {canRemove && (
                  <button
                    type="button"
                    aria-label={`Remove ${ws.name}`}
                    title="Remove workspace"
                    className="hidden h-6 w-6 shrink-0 items-center justify-center rounded text-muted-foreground transition-colors hover:bg-accent hover:text-destructive group-hover:flex"
                    onPointerDown={(e) => e.stopPropagation()}
                    onClick={(e) => {
                      e.preventDefault();
                      e.stopPropagation();
                      removeWorkspace(ws.id);
                    }}
                  >
                    <Trash2 className="h-3.5 w-3.5" />
                  </button>
                )}
              </DropdownMenuItem>
            );
          })}
          <DropdownMenuSeparator />
          <DropdownMenuItem
            onSelect={(e) => {
              e.preventDefault();
              resetForm();
              setAddOpen(true);
            }}
          >
            <PlusIcon className="mr-2 h-4 w-4" />
            Add a workspace…
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>

      <Dialog open={addOpen} onOpenChange={(open) => (open ? setAddOpen(true) : closeAdd())}>
        <DialogContent className="sm:max-w-[440px]">
          <DialogHeader>
            <DialogTitle>Add a workspace</DialogTitle>
            <DialogDescription>
              Connect to another OpenBook server. Switching to it re-points this device at that server.
            </DialogDescription>
          </DialogHeader>
          <div className="flex flex-col gap-4 py-1">
            <div className="flex gap-3">
              <div className="flex w-16 flex-col gap-1.5">
                <Label htmlFor="ws-icon">Icon</Label>
                <Input
                  id="ws-icon"
                  value={icon}
                  maxLength={2}
                  placeholder="📓"
                  className="text-center text-lg"
                  onChange={(e) => setIcon(e.target.value)}
                />
              </div>
              <div className="flex flex-1 flex-col gap-1.5">
                <Label htmlFor="ws-name">Name</Label>
                <Input
                  id="ws-name"
                  value={name}
                  placeholder="Home wiki"
                  onChange={(e) => setName(e.target.value)}
                />
              </div>
            </div>
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="ws-url">Server URL</Label>
              <Input
                id="ws-url"
                value={serverUrl}
                placeholder="https://my-server.example:4319"
                onChange={(e) => {
                  setServerUrl(e.target.value);
                  setError(null);
                }}
                onKeyDown={(e) => e.key === 'Enter' && submitAdd()}
              />
              {error && <p className="text-xs text-destructive">{error}</p>}
            </div>
          </div>
          <DialogFooter>
            <Button variant="ghost" onClick={closeAdd}>
              Cancel
            </Button>
            <Button onClick={submitAdd}>Add workspace</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
