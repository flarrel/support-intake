Feature: Support ticket intake

  Scenario: Review a request the model cannot route confidently
    Given the Support Intake dashboard is open
    When I submit the text "zqxv blorf qqqzx fffjqp"
    Then the ticket should be in manual review
    When I correct its intent and leave a note
    Then the ticket should be routed with the correction in its history

  Scenario: Route the same support message from text and a screenshot
    Given the Support Intake dashboard is open
    When I submit the text "I lost my card and need a new one."
    And I submit a screenshot of the same message
    Then the screenshot should produce the expected text and intent

  Scenario: Reject an invalid screenshot
    Given the Support Intake dashboard is open
    When I submit a fake PNG
    Then the invalid upload should show an error without creating a ticket
