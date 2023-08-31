import React, {useState} from "react";
import {invoke} from "@tauri-apps/api/tauri";
import {DefaultLayout} from "@hyper-hq/hyper-ui";
import {Button, Container, Heading, Section, Text, TextField, Theme} from "@radix-ui/themes";

function App() {
  const [greetMsg, setGreetMsg] = useState("");
  const [name, setName] = useState("");

  async function greet() {
    // Learn more about Tauri commands at https://tauri.app/v1/guides/features/command
    setGreetMsg(await invoke("greet", {name}));
  }

  return (
    <Theme>
      <DefaultLayout>
        <Container>
          <Heading>Hello world</Heading>
          <form
            className="row"
            onSubmit={(e) => {
              e.preventDefault();
              greet();
            }}
          >
            <Section>
              <TextField.Root>
                <TextField.Input
                  id="greet-input"
                  onChange={(e) => setName(e.currentTarget.value)}
                  placeholder="Enter a name..."
                />
              </TextField.Root>
              <Button type="submit">Greet</Button>
              <Text>{greetMsg}</Text>
            </Section>
          </form>
        </Container>
      </DefaultLayout>
    </Theme>
  );
}

export default App;
