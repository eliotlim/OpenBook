import {SlashIcon} from '@radix-ui/react-icons';
import {useNavigation, useWorkspace} from '@/providers';

export interface BreadcrumbProps {
  emoji: string,
  title: string,
}

export function Breadcrumb(props: BreadcrumbProps) {
  return (
    <li className="inline-flex items-center">
      <div className="flex items-center">
        <a href="#"
          className="ml-1 text-sm font-medium text-gray-700 hover:text-blue-600 md:ml-2 dark:text-gray-400 dark:hover:text-white">
          {props.emoji} {props.title}
        </a>
      </div>
    </li>
  );
}

export default function BreadcrumbCluster() {
  const {workspace} = useWorkspace();
  const {pages, currentPageId} = useNavigation();
  const current = pages.find((p) => p.id === currentPageId);
  const pageTitle = current?.name && current.name.trim().length > 0 ? current.name : 'Untitled';
  return (
    <nav className="flex" aria-label="Breadcrumb">
      <ol className="inline-flex items-center space-x-1 md:space-x-3">
        {[
          {emoji: workspace?.icon ?? '💼', title: workspace?.name ?? 'Default Workspace'},
          {emoji: '📄', title: pageTitle},
        ].map((pageDetails) => (
          <Breadcrumb
            emoji={pageDetails.emoji}
            title={pageDetails.title}
            key={`breadcrumb-${pageDetails.title}`}
          />
        )
        ).flatMap((element, index) => [
          index > 0 && (
            <SlashIcon className=""/>
          ),
          element,
        ])}
      </ol>
    </nav>
  );
}
