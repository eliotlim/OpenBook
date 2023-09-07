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
        slotProps={{
          backdrop: {
            sx: {
              opacity: 0,
              backdropFilter: 'none',
            },
          },
        }}
        onClose={() => {
          setSideNav({
            ...sideNav,
            open: false
          });
        }}
        docked={sideNav.docked}
      >
        <Typography>
          Hello World
        </Typography>
      </Drawer>
    </>
  )
}