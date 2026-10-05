// werf cleanup fetches origin's branches and tags to see which images are still in use. Checkout
// keeps no credentials (persist-credentials: false), so this step alone gets the workflow token,
// through git's environment rather than .git/config.
module.exports = (repoString) => `
      - name: Cleanup old images
        env:
          GITHUB_TOKEN: \${{ github.token }}
        run: |
          GIT_AUTH_HEADER="AUTHORIZATION: basic $(printf 'x-access-token:%s' "$GITHUB_TOKEN" | base64 -w0)"
          echo "::add-mask::$GIT_AUTH_HEADER"
          export GIT_CONFIG_COUNT=1
          export GIT_CONFIG_KEY_0=http.https://github.com/.extraheader
          export GIT_CONFIG_VALUE_0="$GIT_AUTH_HEADER"
          werf cleanup \\
            --repo ${repoString}`;
