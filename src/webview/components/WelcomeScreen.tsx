import { For } from "solid-js";

interface WelcomeScreenProps {
  onSuggestion: (prompt: string) => void;
  onOpenProject?: () => void;
}

const suggestions = [
  {
    icon: "✦",
    title: "Launch a landing page",
    description: "A polished site for your next big idea",
    prompt: "Build a polished, responsive landing page for my product. Include a clear hero, benefits, social proof, and a strong call to action.",
  },
  {
    icon: "◈",
    title: "Build a web app",
    description: "Turn an idea into a working product",
    prompt: "Help me turn my idea into a working web app. First inspect this project, then propose a concise plan before making changes.",
  },
  {
    icon: "⌘",
    title: "Fix or improve a project",
    description: "Make an existing project better",
    prompt: "Inspect this project, identify the most important improvement you can make safely, and explain your plan before implementing and testing it.",
  },
  {
    icon: "↗",
    title: "Explore an idea",
    description: "Start with a rough concept",
    prompt: "Help me explore an app idea. Ask only the most important clarifying questions, then turn the answers into a practical build plan.",
  },
];

export function WelcomeScreen(props: WelcomeScreenProps) {
  return (
    <section class="welcome-screen" aria-label="Start building with Axiom">
      <div class="welcome-orb" aria-hidden="true"><span>✳</span></div>
      <div class="welcome-eyebrow"><span class="welcome-status-dot" /> YOUR IDEAS, BUILT WITH AI</div>
      <h1>What are we<br /><span>building today?</span></h1>
      <p class="welcome-description">
        Start with an idea. Axiom can plan the work, build it, and help you shape every detail.
      </p>
      <div class="welcome-primary-actions">
        <button type="button" class="workflow-plan__primary" onClick={() => props.onOpenProject?.()}>Open a project</button>
        <span>or start with an idea below</span>
      </div>
      <div class="welcome-suggestions">
        <For each={suggestions}>
          {(suggestion) => (
            <button
              type="button"
              class="welcome-suggestion"
              onClick={() => props.onSuggestion(suggestion.prompt)}
            >
              <span class="welcome-suggestion-icon" aria-hidden="true">{suggestion.icon}</span>
              <span class="welcome-suggestion-copy">
                <strong>{suggestion.title}</strong>
                <span>{suggestion.description}</span>
              </span>
              <span class="welcome-suggestion-arrow" aria-hidden="true">↗</span>
            </button>
          )}
        </For>
      </div>
      <p class="welcome-footnote">No perfect prompt needed. Just tell Axiom what you have in mind.</p>
    </section>
  );
}
