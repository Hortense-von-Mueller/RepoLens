# RepoLens

RepoLens is a no-dependency web app that scans a sample of a public GitHub repository for common security and engineering-practice signals, then reports a heuristic score from 0 to 10.

## Run locally

Requires Node.js 18 or newer.

```sh
npm start
```

Open [http://localhost:3000](http://localhost:3000) and enter a repository URL such as `https://github.com/owner/repository`.

## What it checks

The scan looks for security policies, dependency update configuration and lockfiles, CI workflows, scoped workflow permissions, pinned GitHub Actions, common test/documentation files, and a small set of risky code patterns. It scans up to 48 prioritized files (up to 180 KB each) from public repositories.

The score is an educational heuristic, not a security audit. It does not inspect private repositories, runtime behavior, dependency vulnerability databases, repository settings, or files outside its sample. Findings can be false positives or miss real problems. GitHub's unauthenticated API rate limits apply.
