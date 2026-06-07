import EmojiPicker, {EmojiStyle, Theme} from 'emoji-picker-react';

/**
 * Thin wrapper over `emoji-picker-react`, isolated in its own module so the host
 * can `React.lazy()` it — the (large) emoji bundle then loads only when a picker
 * is first opened. `EmojiStyle.NATIVE` renders unicode glyphs with **no network**
 * (the default Apple style streams PNG sprites from a CDN — broken offline).
 */
export default function EmojiGrid({
  dark,
  onPick,
}: {
  dark: boolean;
  onPick: (emoji: string) => void;
}) {
  return (
    <EmojiPicker
      emojiStyle={EmojiStyle.NATIVE}
      theme={dark ? Theme.DARK : Theme.LIGHT}
      lazyLoadEmojis
      previewConfig={{showPreview: false}}
      onEmojiClick={(e) => onPick(e.emoji)}
    />
  );
}
