import {NavBar, SideNav} from "@/components";
import {Box} from "@mui/joy";

export interface DefaultLayoutProps {
  children: React.ReactNode;
}

export default function DefaultLayout(props: DefaultLayoutProps) {
  return (
    <>
      <NavBar/>
      <SideNav/>
      <Box
        sx={{
          display: "flex",
          width: "100vw",
          height: "100vh",
          alignItems: "center",
        }}
      >
        {props.children}
      </Box>
    </>
  )
}
