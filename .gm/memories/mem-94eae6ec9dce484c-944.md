---
key: mem-94eae6ec9dce484c-944
ns: default
created: 1783073264833
updated: 1783073264833
---

## Resolved mutable: git-push-blocked-real-version-conflict

Resolved by splitting the commit: reset --soft to the shared base (4839abe), set package.json's version back to match origin's current value exactly (2.0.15, byte-identical) so the code+test changes carried zero diff on the conflicting line, committed+pushed via git_finalize (sha dddaad2) -- this succeeded cleanly (git_finalize reported pushed:true; verified via git_fetch origin master, confirmed FETCH_HEAD moved d023a69..bc95bfa and origin/master:package.json now reads version 2.0.16, since CI's own release pipeline auto-bumped and pushed a bc95bfa 'chore release v2.0.16 [skip ci]' commit on top immediately after -- so origin now correctly carries both the real fix commit AND the version bump, done by CI rather than manually, avoiding the recurring same-line conflict entirely). Local git status --porcelain clean, git log confirms d023a69 is an ancestor of origin/master.
