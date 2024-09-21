import * as child_process from "node:child_process";

function setupEnvironment() {
  console.log('Linking subpackages...');

  const subpackages: Record<string, string> = {
    "@open-book/ui": "packages/ui",
  };

  Object.keys(subpackages).map((packageName) => {
    const packagePath = subpackages[packageName];
    try {
      console.log(`Linking ${packageName} to ${packagePath}`)
      child_process.execSync(`cd ${packagePath} && npm link`);
      child_process.execSync(`npm link ${packageName}`)
    } catch (e) {
      console.error(e);
    }
  });

  console.log('Done');
}

setupEnvironment();
