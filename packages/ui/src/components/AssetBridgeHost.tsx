import {useEffect} from 'react';
import {useData} from '@/data';
import {setAssetBridge} from '@/lib/assetBridge';

/**
 * Installs the asset bridge (lib/assetBridge) for the provider-less block editor,
 * wired to the current data client. Renders nothing. Mounted once at the app root
 * (alongside AiBridgeHost) so the image block's ingest can upload file bytes and
 * its view can resolve an assetId → object URL without touching React context.
 */
export function AssetBridgeHost() {
  const client = useData();
  useEffect(() => {
    setAssetBridge({
      putAsset: (bytes, mime, pageId) => client.putAsset(bytes, mime, pageId),
      getAsset: (id) => client.getAsset(id),
    });
    return () => setAssetBridge(null);
  }, [client]);
  return null;
}

export default AssetBridgeHost;
