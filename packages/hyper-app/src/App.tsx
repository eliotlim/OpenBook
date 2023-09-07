import React, {useState} from "react";
import {invoke} from "@tauri-apps/api/tauri";
import {DefaultLayout, PageDocument, SideNavProvider} from "@hyper-hq/hyper-ui";
import {Container, CssBaseline, CssVarsProvider} from "@mui/joy";

function App() {
  const [greetMsg, setGreetMsg] = useState("");
  const [name, setName] = useState("");

  async function greet() {
    // Learn more about Tauri commands at https://tauri.app/v1/guides/features/command
    setGreetMsg(await invoke("greet", {name}));
  }

  return (
    <CssVarsProvider defaultMode="system">
      <CssBaseline/>
      <SideNavProvider>
        <DefaultLayout>
          <PageDocument/>
        </DefaultLayout>
      </SideNavProvider>
    </CssVarsProvider>
  );
}

export default App;
