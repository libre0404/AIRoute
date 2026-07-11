export function registerProvider(program) {
  program
    .command("provider [subcommand]")
    .description("Manage provider connections (use 'providers' for the full interface)")
    .allowUnknownOption()
    .allowExcessArguments()
    .action(() => {
      console.log(`
  Use \`AIRoute providers\` for the full provider management interface:

    AIRoute providers available   — show provider catalog
    AIRoute providers list        — list configured connections
    AIRoute providers test <name> — test a provider connection
    AIRoute providers test-all    — test all active connections
    AIRoute providers validate    — validate local configuration
`);
    });
}
