import {NavBar, SideNav} from '@/components';
import {ScrollArea} from "@/components/ui/scroll-area";

export interface DefaultLayoutProps {
  children: React.ReactNode;
}

export default function DefaultLayout(props: DefaultLayoutProps) {
  return (
    <>
      <NavBar/>
      <div className="flex flex-row">
        <SideNav/>
        <ScrollArea className="w-full h-screen transition-all duration-500 transform">
          {props.children}
        </ScrollArea>
      </div>
    </>
  );
}
