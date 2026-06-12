import {useEffect} from 'react';
import {useData} from '@/data';
import {syncPlugins} from '@/plugins';

/** Loads the workspace's enabled extensions once the data client exists. */
export default function PluginBoot() {
  const client = useData();
  useEffect(() => {
    void syncPlugins(client).catch(() => undefined);
  }, [client]);
  return null;
}
