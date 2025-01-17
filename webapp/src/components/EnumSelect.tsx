import { ReactNode, useState } from "react"

import { Select, SelectOption } from "@patternfly/react-core"

type EnumSelectProps = {
    options: Record<string, ReactNode>
    selected: string | undefined
    onSelect(option: string): void
    isDisabled?: boolean
}

export default function EnumSelect(props: EnumSelectProps) {
    const [isOpen, setOpen] = useState(false)
    return (
        <Select
            isOpen={isOpen}
            onToggle={setOpen}
            placeholderText="Please select..."
            selections={props.selected}
            onSelect={(_, value) => {
                props.onSelect(value as string)
                setOpen(false)
            }}
            isDisabled={props.isDisabled}
        >
            {Object.entries(props.options).map(([name, title]) => (
                <SelectOption key={name} value={name}>
                    {title}
                </SelectOption>
            ))}
        </Select>
    )
}
