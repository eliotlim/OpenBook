import React, {useState} from "react";
import {invoke} from "@tauri-apps/api/tauri";
import {DefaultLayout, SideNavProvider} from "@hyper-hq/hyper-ui";
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
          <h1>Hello world</h1>
          <Container>
            <form
              className="row"
              onSubmit={(e) => {
                e.preventDefault();
                greet();
              }}
            >
              <input
                id="greet-input"
                onChange={(e) => setName(e.currentTarget.value)}
                placeholder="Enter a name..."
              />
              <button type="submit">Greet</button>
            </form>

            <p>{greetMsg}</p>
          </Container>
        </DefaultLayout>
      </SideNavProvider>
    </CssVarsProvider>
  );
}

export default App;
