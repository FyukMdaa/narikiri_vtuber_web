{
  description = "devenv";

  inputs = {
    nixpkgs.url = "github:nixos/nixpkgs/nixpkgs-unstable";
    flake-utils.url = "github:numtide/flake-utils";
  };

  outputs = {
    nixpkgs,
    flake-utils,
    ...
  }:
    flake-utils.lib.eachDefaultSystem (
      system: let
        pkgs = nixpkgs.legacyPackages.${system};
        inherit (pkgs) importNpmLock;
        nodejs = pkgs.nodejs_24;
        npmRoot = ./.;
      in {
        devShells.default = pkgs.mkShell {
          packages = [
            importNpmLock.hooks.linkNodeModulesHook
            nodejs
            pkgs.http-server
          ];
          npmDeps = importNpmLock.buildNodeModules {
            inherit npmRoot nodejs;
          };
          shellHook = ''
            if [ -n "''${npmDeps:-}" ]; then
              rm -rf node_modules
              ln -s "$npmDeps/node_modules" node_modules
            fi
            echo "Node.js version: $(node -v)
            add:
            npm install -D <package-name>@<version> --package-lock-only
            remove:
            npm uninstall -D <package-name> --package-lock-only
            convert package.json to package-lock.json:
            npm install --package-lock-only"
          '';
        };
      }
    );
}
