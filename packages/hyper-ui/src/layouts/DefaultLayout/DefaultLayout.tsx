import {NavBar} from "@/components";
import {Box, Grid} from "@radix-ui/themes";
import SideNav from "@/components/SideNav/SideNav";

export interface DefaultLayoutProps {
  children: React.ReactNode;
}

export default function DefaultLayout(props: DefaultLayoutProps) {
  return (
    <>
      <NavBar/>
      <Grid columns="3">
        <SideNav/>
        <Box
          style={{
            display: "flex",
            width: "100vw",
            height: "100vh",
            alignItems: "center",
          }}
        >
          {props.children}
        </Box>

      </Grid>
    </>
  )
}
