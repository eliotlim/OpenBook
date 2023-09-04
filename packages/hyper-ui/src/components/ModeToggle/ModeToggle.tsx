import { useColorScheme, Button } from '@mui/joy';

export default function ModeToggle() {
  const { mode, setMode } = useColorScheme();
  return (
    <Button
      variant="outlined"
      color="neutral"
      onClick={() => setMode(mode === 'dark' ? 'light' : 'dark')}
    >
      {mode === 'dark' ? '🌘' : '☀️'}
    </Button>
  );
}