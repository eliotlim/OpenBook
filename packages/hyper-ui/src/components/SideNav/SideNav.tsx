import {Drawer} from "@/components/Drawer";
import {useSideNav} from "@/providers";
import {Typography} from "@mui/joy";

export default function SideNav() {
  const {sideNav, setSideNav} = useSideNav();
  return (
    <>
      <Drawer
        title="Hello World"
        open={sideNav.open}
        onClose={() => {
          setSideNav({
            ...sideNav,
            open: false
          });
        }}
      >
        <Typography>
          Hello World
        </Typography>
      </Drawer>
    </>
  )
}