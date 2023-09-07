import {Editor} from 'novel';
import {Stack, Typography} from "@mui/joy";

const PageDocument = () => {
  return (
    <Stack
      sx={{
        paddingTop: 5,
      }}
      gap={3}
    >
      <Stack>
        <Typography level="h1">
          Untitled Page
        </Typography>
      </Stack>
      <Editor/>
    </Stack>
  );
}

export default PageDocument;
