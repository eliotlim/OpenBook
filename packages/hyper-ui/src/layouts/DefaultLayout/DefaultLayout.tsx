import {NavBar, SideNav} from "@/components";

export interface DefaultLayoutProps {
  children: React.ReactNode;
}

export default function DefaultLayout(props: DefaultLayoutProps) {
  return (
    <>
      <NavBar/>
      <SideNav/>
      {props.children}
    </>
  )
}
