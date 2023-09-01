import {
  Button,
  DropdownMenu,
  Flex,
  Heading
} from "@radix-ui/themes";

export default function SideNav() {
  return (
    <>
      <Flex
        style={{
          textAlign: 'center',
          justifyContent: 'left',
          paddingTop: 40,
          width: '300px',
          height: '100vh',
          zIndex: 1000,
          backdropFilter: 'blur(10px)',
        }}
      >
        <DropdownMenu.Root>
          <DropdownMenu.Trigger>
            <Button>
              <Heading size="4">Workspaces</Heading>
            </Button>
          </DropdownMenu.Trigger>
          <DropdownMenu.Content>
            <DropdownMenu.Item>

            </DropdownMenu.Item>
          </DropdownMenu.Content>

        </DropdownMenu.Root>
      </Flex>
    </>
  )
}