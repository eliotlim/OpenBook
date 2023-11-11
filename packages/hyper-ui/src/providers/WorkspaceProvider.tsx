import React, {createContext, PropsWithChildren, useContext, useState} from 'react';

export interface PageRecord {
  pageId: string;
  icon: string;
  title: string;
  content: string;
}

export interface NavPageRecord extends PageRecord {
  subPages?: PageRecord[];
}

export interface Workspace {
  workspaceId: string;
  icon: string;
  name: string;
  uri: string;
  pages: NavPageRecord[];
}

export interface WorkspaceContext {
  workspace: Workspace | null;
  setWorkspace: React.Dispatch<Workspace | ((draft: Workspace) => Workspace)>;
}

export const WorkspaceContext = createContext<WorkspaceContext>({
  workspace: null,
  setWorkspace: () => false
});

export const useWorkspace = () => useContext(WorkspaceContext);

export const loadWorkspaceStorage = (): Workspace => {
  const workspace = localStorage.getItem('workspace');
  if (workspace === null) {
    return {
      workspaceId: 'workspace-abcdef',
      icon: '🏡',
      name: 'Default Workspace',
      uri: 'https://space1.hyper.dev',
      pages: [
        {
          pageId: 'default2',
          icon: '🏠',
          title: 'Default Page',
          content: 'This is the default page',
          subPages: [
            {
              pageId: 'default3',
              icon: 'https://www.google.com/s2/favicons?sz=64&domain=google.com',
              title: 'Default Sub Page',
              content: 'This is the default sub page',
            },
          ],
        },
      ],
    };
  }
  return JSON.parse(workspace);
};

export const WorkspaceProvider: React.FC<PropsWithChildren<unknown>> = ({children}) => {
  const [workspace, setWorkspace] = useState(loadWorkspaceStorage);
  return <WorkspaceContext.Provider value={{workspace, setWorkspace}}>
    {children}
  </WorkspaceContext.Provider>;
};
