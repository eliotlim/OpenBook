import {Button} from '@/components/ui/button';
import {useWorkspace} from "@/providers/WorkspaceProvider";

export default function WorkspaceNavigationTree (){
  const {workspace} = useWorkspace();

  return (
    <>
      {[
        {
          emoji: '🏠',
          title: 'Home',
        },
        ...(new Array(40).fill(0).map((_, i) => ({
          emoji: '📄',
          title: `Untitled Page ${i + 1}`,
        }))),
      ].map((pageDetails) => (
        <Button
          variant="ghost"
          key={`breadcrumb-${pageDetails.title}`}
          className="flex items-center gap-2 px-2 py-1"
        >
          <span className="text-2xl">{pageDetails.emoji}</span>
          <span>{pageDetails.title}</span>
        </Button>
      ))}
    </>
  );
}