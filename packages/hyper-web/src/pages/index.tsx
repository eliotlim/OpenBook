import Head from 'next/head'
import {DefaultLayout} from '@hyper-hq/hyper-ui'
import React, {useState} from "react";
import {Button, Container, Heading, Section, Text, TextField} from "@radix-ui/themes";

export default function Home() {
  const [greetMsg, setGreetMsg] = useState("");
  const [name, setName] = useState("");

  async function greet() {
    // Learn more about Tauri commands at https://tauri.app/v1/guides/features/command
    setGreetMsg(`Hello ${name}!`);
  }

  return (
    <>
      <Head>
        <title>Hyper</title>
        <meta name="description" content="Hyper Web Client"/>
        <meta name="viewport" content="width=device-width, initial-scale=1"/>
        <link rel="icon" href="/favicon.ico"/>
      </Head>
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
    </>
  )
}
