import {NavBar} from "@/components";
import {Box} from "@radix-ui/themes";

export interface DefaultLayoutProps {
  children: React.ReactNode;
}

export default function DefaultLayout(props: DefaultLayoutProps) {
  return (
    <>
      <NavBar/>
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
    </>
  )
}
