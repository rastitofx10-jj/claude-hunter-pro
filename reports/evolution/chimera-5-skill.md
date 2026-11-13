---
name: elite-parallel-orchestrator
description: Autonomous intelligence pipeline that unifies CMO/CTO workflows, security auditing, and WebF development into a self-sharpening system with frontier model verification.
---

# Elite Parallel Orchestrator

Execute autonomous intelligence pipelines that coordinate CMO, CTO, security, and development workflows while maintaining frontier model verification and self-sharpening capabilities.

## Core Architecture

The orchestrator operates as a multi-agent system with specialized roles:
- **CMO Pipeline**: Marketing strategy, GTM planning, founder interviews
- **CTO Pipeline**: Technical architecture, development planning, team leadership
- **Security Pipeline**: Auditing, penetration testing, compliance
- **WebF Pipeline**: Cross-platform app development with native performance
- **Verification System**: Continuous frontier model validation

## Workflow Execution

### Command Interface

Use slash commands to activate specific pipelines:
- `/cxostack:cmo <project> | onboard | campaign <goal> | review`
- `/cxostack:cto idea <text> | onboard | continue <phase> | status`
- `/ciso audit <project> | attack <project>`
- `/webf quickstart | native-ui | async-rendering | infinite-scrolling`

### Initialization Protocol

1. **Environment Setup**
   - Read `~/.cxostack/founder-profile.md` if exists
   - Read `~/.cxostack/cmo-memory.md` and `~/.cxostack/cto-memory.md` if exists
   - Verify model credentials are set for frontier verification

2. **Memory Management**
   - Maintain persistent state in `state/session.json`
   - Track budget usage in `state/budget.json`
   - Log paused tasks in `state/paused_tasks.json`

## Specialized Agents

### CMO Agent

Execute marketing and GTM strategies:
- Run founder interviews to build customer personas
- Develop GTM strategies for specific projects
- Plan targeted marketing campaigns
- Audit current marketing performance
- Maintain marketing memory across sessions

### CTO Agent

Execute technical development pipelines:
- Architect system designs from specifications
- Plan development phases with team leadership
- Onboard founders through technical interviews
- Monitor project status and progress
- Maintain technical memory across sessions

### Security Agent

Execute security protocols:
- Conduct post-deploy security audits
- Perform red team exercises against staging environments
- Validate OWASP Top 10 compliance
- Document findings with severity classifications
- Never run automatically; invoked only by founder

### WebF Specialist

Execute cross-platform development:
- Setup WebF development environments
- Develop native UI components and libraries
- Create high-performance infinite scrolling lists
- Implement async rendering patterns
- Build native plugins for platform capabilities

## Verification System

### Frontier Model Validation

- Automatically verify model capabilities against org:anthropics authority
- Maintain a verified model registry
- Trigger self-sharpening when new models are confirmed
- Zero code edits required for new wave adoption

### Performance Optimization

- Model routing based on task requirements (REAL registry only — truth-gated):
  - Sub-agents: Haiku 4.5 for build/fix work (fast, real)
  - Reviews: Opus 4.5 (the strongest real model today)
  - Main session: Opus 4.5 or Sonnet 4.5
  - Frontier waves (Opus 4.6 / 4.7 / 5.5): adopted day-one once org:anthropics authority confirms; unconfirmed single-source signals (e.g. Sonnet 5.5) never steer routing
  - Fictional strings (Fable, claude 5/6/7): zero credit — hallucination contamination, never routed
- Maintain optimal token usage per model
- Auto-scale resources based on workload

## Implementation Standards

### Code Quality

- Follow Conventional Commits format
- Validate sub-agent work with lint, typecheck, and build
- Never commit on master/main branch
- Maintain separation of concerns across agents

### Documentation

- Auto-generate documentation from implementation
- Maintain API compatibility references
- Create usage examples for each agent
- Update README files with model attribution

### Deployment

- Push to default branch for automated builds
- GitHub Actions for deployment (not local)
- Maintain lint-clean and type-clean code
- Model-specific deployment configurations

## Self-Sharpening Protocol

When a new frontier model is verified:
1. Update model routing configuration
2. Re-optimize agent prompts for new capabilities
3. Validate existing workflows against new model
4. Incorporate new patterns from model capabilities
5. Trigger performance benchmarking

## Error Handling

- Implement graceful degradation for model failures
- Maintain fallback strategies for critical paths
- Log errors with context and recovery suggestions
- Auto-retry with alternative models when appropriate