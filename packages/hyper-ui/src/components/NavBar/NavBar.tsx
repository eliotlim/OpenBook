import {
  Button,
  Container,
  Flex,
  Heading
} from "@radix-ui/themes";
import {ModeToggle} from "../ModeToggle";

export default function NavBar() {
  return (
    <>
      <Container
        style={{
          textAlign: 'center',
          justifyContent: 'center',
          position: 'fixed',
          width: '100vw',
          zIndex: 1000,
          backdropFilter: 'blur(10px)',
        }}
      >
        <Flex dir="ltr" style={{justifyContent: 'space-between'}}>
          <Button
            variant="soft"
          >
            <Heading size="4">hyper</Heading>
          </Button>
          <ModeToggle/>
        </Flex>
      </Container>
    </>
  )
}