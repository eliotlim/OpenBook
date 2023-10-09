import {NavBar, SideNav} from '@/components';
import {ScrollArea} from "@/components/ui/scroll-area";

export interface DefaultLayoutProps {
  children: React.ReactNode;
}

export default function DefaultLayout(props: DefaultLayoutProps) {
  return (
    <>
      <div className="flex flex-row items-stretch overflow-hidden">
        <SideNav/>
        <div className="flex flex-col h-screen w-full">
          <NavBar/>
          <ScrollArea className="flex w-full">
            {props.children}
          </ScrollArea>
        </div>
      </div>
    </>
  );
}
