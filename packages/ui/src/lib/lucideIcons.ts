/**
 * The curated set of Lucide icons offered by the icon picker and rendered for
 * `lucide:<Name>` page icons (see {@link components/PageIcon}).
 *
 * We import a hand-picked subset explicitly rather than the whole `lucide-react`
 * package (~1,500 icons) so the always-loaded bundle stays small and the picker
 * shows a tidy, useful gallery instead of an overwhelming wall. The registry is
 * the single extension point: add names here to grow the set, and later icon
 * *sources* (custom uploads, other libraries) can sit beside it behind the same
 * `lucide:`-style prefix scheme (#5).
 */
import {
  Activity, AlarmClock, AlertTriangle, Anchor, Aperture, Archive, Award, Backpack,
  BarChart3, Battery, Beaker, Bell, Bike, Binary, Bird, Book, Bookmark, BookOpen,
  Box, Brain, Briefcase, Brush, Bug, Building2, Bus, Cake, Calculator, Calendar,
  Camera, Car, Carrot, Check, CheckCircle2, ChefHat, Cherry, Circle, Clapperboard,
  Clipboard, Clock, Cloud, Code2, Coffee, Cog, Coins, Compass, Cpu, CreditCard,
  Crown, Database, Diamond, Dog, DollarSign, Download, Droplet, Dumbbell, Egg, Eye,
  Feather, FileText, Film, Filter, Flag, Flame, FlaskConical, Flower2, Folder,
  Footprints, Gamepad2, Gauge, Gem, Gift, GitBranch, Globe, GraduationCap, Grid3x3,
  Hammer, Hand, Hash, Headphones, Heart, HelpCircle, Home, Image, Inbox, Infinity as InfinityIcon,
  Info, Key, Keyboard, Lamp, Laptop, Layers, Layout, Leaf, Library, Lightbulb, Link,
  List, Lock, Mail, Map, MapPin, Megaphone, MessageCircle, MessageSquare, Mic,
  Monitor, Moon, Mountain, Mouse, Music, Navigation, Newspaper, Package, Palette,
  PanelLeft, Paperclip, PartyPopper, Pencil, PenTool, Phone, PieChart, PiggyBank,
  Pin, Plane, Play, Plug, Plus, Puzzle, Rabbit, Radio, Rocket, Ruler, Save, Scale,
  Scissors, Search, Send, Settings, Share2, Shield, ShoppingBag, ShoppingCart, Smile,
  Snowflake, Sparkles, Speaker, Sprout, Star, Sticker, Sun, Sword, Table, Tag, Target,
  Tent, Terminal, ThumbsUp, Ticket, Timer, ToggleLeft, Trash2, TreePine, TrendingUp,
  Trophy, Truck, Tv, Umbrella, User, Users, Utensils, Video, Wallet, Wand2, Watch,
  Waves, Wifi, Wind, Wrench, Zap, type LucideIcon,
} from 'lucide-react';
import {LUCIDE_PREFIX, isLucideIcon} from '@/lib/iconValue';

// Re-export the pure value helpers so existing `lib/lucideIcons` imports keep
// working; the prefix/predicate themselves live in the lucide-free module.
export {LUCIDE_PREFIX, isLucideIcon};

/** Name → component, in a deliberate, roughly-themed display order. Each icon
 *  appears exactly once; the key is the value persisted as `lucide:<key>`. */
export const LUCIDE_ICONS: Record<string, LucideIcon> = {
  // general / favourites
  Star, Heart, Bookmark, Flag, Pin, Tag, Crown, Award, Trophy, Gem, Diamond, Sparkles,
  Flame, Zap, Gift, PartyPopper, Smile, ThumbsUp, Check, CheckCircle2, Target, Infinity: InfinityIcon,
  // documents / work
  FileText, Folder, Book, BookOpen, Library, Newspaper, Clipboard, List, Archive, Inbox,
  Briefcase, Calendar, Clock, AlarmClock, Timer, Paperclip,
  // data / charts
  BarChart3, PieChart, TrendingUp, Table, Grid3x3, Database, Layers, Gauge, Calculator,
  // money
  DollarSign, Coins, Wallet, CreditCard, PiggyBank, ShoppingBag, ShoppingCart, Scale,
  // tech / dev
  Code2, Terminal, Cpu, Binary, GitBranch, Bug, Cog, Settings, Wrench, Hammer, Plug, Key,
  Lock, Shield, Wifi, Monitor, Laptop, Keyboard, Mouse,
  // communication
  Mail, MessageCircle, MessageSquare, Send, Bell, Megaphone, Phone, Share2, Link, Hash,
  // media
  Image, Camera, Video, Film, Clapperboard, Music, Headphones, Mic, Speaker, Radio, Tv,
  Play, Gamepad2, Palette, Brush, PenTool, Pencil, Aperture,
  // people / body
  User, Users, Hand, Eye, Brain, Footprints, GraduationCap, Dumbbell,
  // nature / weather
  Leaf, Sprout, Flower2, TreePine, Mountain, Globe, Sun, Moon, Cloud, Snowflake,
  Droplet, Waves, Wind, Umbrella, Feather, Bird, Dog, Rabbit,
  // food
  Coffee, Utensils, Cake, ChefHat, Carrot, Cherry, Egg, Beaker, FlaskConical,
  // travel / places
  Home, Building2, Tent, MapPin, Map, Compass, Navigation, Rocket, Plane, Car, Bus, Bike,
  Truck, Anchor, Backpack, Ticket, Lamp,
  // misc objects
  Lightbulb, Box, Package, Puzzle, Ruler, Scissors, Sword, Sticker, Watch, Battery,
  Wand2, Activity,
  // ui / status
  Search, Filter, Plus, Download, Save, Trash2, Info, HelpCircle, AlertTriangle,
  ToggleLeft, PanelLeft, Layout, Circle,
};

/** The picker's display order. */
export const LUCIDE_ICON_NAMES: string[] = Object.keys(LUCIDE_ICONS);

/** Resolve a `lucide:Name` value (or a bare `Name`) to its component, or null. */
export function lucideIconFor(value: string): LucideIcon | null {
  const name = value.startsWith(LUCIDE_PREFIX) ? value.slice(LUCIDE_PREFIX.length) : value;
  return LUCIDE_ICONS[name] ?? null;
}
