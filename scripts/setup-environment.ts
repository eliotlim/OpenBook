import * as child_process from "node:child_process";

function setupEnvironment() {
  console.log('Linking subpackages...');
  [
    'packages/ui',
  ].map((packagePath) => {
    try {
      console.log(`Linking ${packagePath}`)
      child_process.execSync(`cd ${packagePath} && npm link`);
    } catch (e) {
      console.error(e);
    }
  });

  console.log('Done');
}

setupEnvironment();
