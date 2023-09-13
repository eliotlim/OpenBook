import {NavBar, SideNav} from "@/components";
import {
  Box,
  Stack
} from "@mui/joy";

export interface DefaultLayoutProps {
  children: React.ReactNode;
}

export default function DefaultLayout(props: DefaultLayoutProps) {
  return (
    <>
      <NavBar/>
      <Stack direction="row" gap={3}>
        <SideNav/>
        <Box>
          {props.children}
        </Box>
      </Stack>
    </>
  )
}
