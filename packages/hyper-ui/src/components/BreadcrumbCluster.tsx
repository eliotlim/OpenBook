import {SlashIcon} from '@radix-ui/react-icons';

export default function BreadcrumbCluster() {
  return (
    <nav className="flex" aria-label="Breadcrumb">
      <ol className="inline-flex items-center space-x-1 md:space-x-3">
        {[
          {emoji: '💼', title: 'Workspace 1'},
          {emoji: '🏠', title: 'Home'},
          {emoji: '📄', title: 'Untitled Page'},
        ].map((pageDetails) => (
          <li className="inline-flex items-center" key={`breadcrumb-${pageDetails.title}`}>
            <div className="flex items-center">
              <a href="#"
                className="ml-1 text-sm font-medium text-gray-700 hover:text-blue-600 md:ml-2 dark:text-gray-400 dark:hover:text-white">
                {pageDetails.emoji} {pageDetails.title}
              </a>
            </div>
          </li>
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
