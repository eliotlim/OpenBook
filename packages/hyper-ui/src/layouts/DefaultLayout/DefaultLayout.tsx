import {NavBar} from "@/components";
import {Box} from "@mui/joy";
import React, {ReactNode} from "react";

export interface DefaultLayoutProps {
  children: ReactNode;
}

export default function DefaultLayout(props: DefaultLayoutProps) {
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
