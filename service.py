def calculate_total(numbers):
    total = 0

    for number in numbers:
        total += number

    return total


def calculate_average(numbers):
    if not numbers:
        return 0

    return calculate_total(numbers) / len(numbers)
