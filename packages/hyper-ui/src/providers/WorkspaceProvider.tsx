import React, {createContext, PropsWithChildren, useContext, useState} from 'react';

export interface PageRecord {
  pageId: string;
  icon: string;
  title: string;
  content: string;
}

export interface NavPageRecord extends PageRecord {
  subPages?: NavPageRecord[];
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
      name: 'My Workspace',
      uri: 'https://space1.hyper.dev',
      pages: [
        {
          pageId: 'default2',
          icon: '📄',
          title: 'Checklist',
          content: 'Simple checklist',
          subPages: [
            {
              pageId: 'subpage1',
              icon: '📝',
              title: 'SubPage 1',
              content: 'Sub page 1',
              subPages: [
                {
                  pageId: 'subpage1',
                  icon: '📝',
                  title: 'SubPage 1',
                  content: 'Sub page 1',
                },
              ],
            },
            {
              pageId: 'subpage2',
              icon: '📝',
              title: 'SubPage 2',
              content: 'Sub page 2',
            },
            {
              pageId: 'subpage3',
              icon: '📝',
              title: 'SubPage 3',
              content: 'Sub page 3',
            },
          ],
        },
        {
          pageId: 'default3',
          icon: '📄',
          title: 'New Page',
          content: 'This is the default page',
          subPages: [
            {
              pageId: 'default3',
              icon: '📝',
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
