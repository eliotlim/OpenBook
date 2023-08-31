import {
  Box,
  Button,
  Container,
  Heading
} from "@radix-ui/themes";
import {ModeToggle} from "../ModeToggle";

export default function NavBar() {
  return (
    <>
      <Box
        style={{
          textAlign: 'center',
          justifyContent: 'center',
          paddingTop: 2,
          gap: 2,
          position: 'fixed',
          width: '100%',
          zIndex: 1000,
          backdropFilter: 'blur(10px)',
        }}
      >
        <Container>
          <Box dir="ltr" style={{justifyContent: 'space-between'}}>
            <Button
              variant="soft"
            >
              <Heading size="4">hyper</Heading>
            </Button>
            <ModeToggle/>
          </Box>
        </Container>
        {/*<Divider/>*/}
      </Box>
    </>
  )
}