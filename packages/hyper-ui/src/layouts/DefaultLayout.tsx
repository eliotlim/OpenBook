import NavBar from "@/components/NavBar";
import {Box} from "@mui/joy";
import {ReactNode} from "react";

export interface DefaultLayoutProps {
  children: ReactNode;
}

export function DefaultLayout(props: DefaultLayoutProps) {
  return (
    <>

      <NavBar/>
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
