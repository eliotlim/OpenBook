import {Button} from '@radix-ui/themes';

export default function ModeToggle() {
  // const { mode, setMode } = useColorScheme();
  return (
    <Button
      variant="soft"
      color="tomato"
      // onClick={() => setMode(mode === 'dark' ? 'light' : 'dark')}
    >
      {/*{mode === 'dark' ? '🌘' : '☀️'}*/}
    </Button>
  );
}